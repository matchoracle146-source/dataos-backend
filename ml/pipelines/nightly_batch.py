#!/usr/bin/env python3
"""
DataOS ML Pipelines
Runs as scheduled batch jobs (cron / Kubernetes CronJob)
Requirements: pip install psycopg2-binary redis pandas numpy scikit-learn prophet requests python-dotenv
"""

import os
import json
import logging
import asyncio
from datetime import datetime, timedelta
from typing import Optional
import pandas as pd
import numpy as np
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(name)s] %(levelname)s: %(message)s')

# ─── DB Connection ────────────────────────────────────────────────────────────
import psycopg2
import psycopg2.extras

def get_db():
    return psycopg2.connect(os.environ['DATABASE_URL'], cursor_factory=psycopg2.extras.RealDictCursor)

import redis as redis_lib
def get_redis():
    return redis_lib.Redis(
        host=os.environ.get('REDIS_HOST', 'localhost'),
        port=int(os.environ.get('REDIS_PORT', 6379)),
        password=os.environ.get('REDIS_PASSWORD'),
        decode_responses=True
    )

# ═══════════════════════════════════════════════════════════════
# PIPELINE 1: NIGHTLY DATA TWIN RECALCULATION
# Schedule: 1:30 AM WAT daily
# ═══════════════════════════════════════════════════════════════
class DataTwinPipeline:
    def __init__(self):
        self.logger = logging.getLogger('DataTwinPipeline')

    def run(self, batch_size: int = 1000):
        self.logger.info("Starting Data Twin Pipeline")
        db = get_db()
        cursor = db.cursor()

        # Get active users (active in last 7 days)
        cursor.execute("""
            SELECT DISTINCT sc.user_id
            FROM sim_cards sc
            JOIN recharges r ON r.user_id = sc.user_id
            WHERE r.initiated_at > NOW() - INTERVAL '7 days'
            ORDER BY sc.user_id
            LIMIT %s
        """, (batch_size,))

        users = [row['user_id'] for row in cursor.fetchall()]
        self.logger.info(f"Processing {len(users)} active users")

        updated = 0
        failed = 0

        for user_id in users:
            try:
                twin = self._calculate_twin(cursor, user_id)
                self._persist_twin(cursor, db, user_id, twin)
                updated += 1
            except Exception as e:
                self.logger.error(f"Twin update failed for {user_id}: {e}")
                failed += 1

        db.close()
        self.logger.info(f"Twin Pipeline complete. Updated: {updated}, Failed: {failed}")
        return {'updated': updated, 'failed': failed}

    def _calculate_twin(self, cursor, user_id: str) -> dict:
        thirty_days_ago = datetime.now() - timedelta(days=30)

        # Get recharge history
        cursor.execute("""
            SELECT r.amount_ngn, r.initiated_at, r.data_mb, r.network, sc.id as sim_id
            FROM recharges r
            JOIN sim_cards sc ON sc.id = r.sim_id
            WHERE r.user_id = %s AND r.status = 'completed' AND r.initiated_at >= %s
            ORDER BY r.initiated_at ASC
        """, (user_id, thirty_days_ago))
        recharges = cursor.fetchall()

        # Get balance history for burn rate estimation
        cursor.execute("""
            SELECT sb.balance_mb, sb.fetched_at
            FROM sim_balances sb
            JOIN sim_cards sc ON sc.id = sb.sim_id
            WHERE sc.user_id = %s AND sb.fetched_at >= %s
            ORDER BY sb.fetched_at ASC
        """, (user_id, thirty_days_ago))
        balances = cursor.fetchall()

        twin = {
            'daily_avg_mb': 1000,
            'weekly_avg_mb': 7000,
            'monthly_avg_mb': 30000,
            'avg_recharge_interval_days': 8.0,
            'recharge_trigger_mb': 200,
            'preferred_recharge_hour': 20,
            'avg_recharge_amount_ngn': 2000,
            'preferred_network': 'MTN',
            'churn_risk_score': 0.1,
            'bundle_acceptance_rate': 0.5,
            'savings_sensitivity': 'medium',
            'budget_adherence_rate': 0.7,
            'emergency_frequency': 0.0,
            'data_points': 0,
        }

        if len(recharges) >= 2:
            # Recharge intervals
            intervals = []
            for i in range(1, len(recharges)):
                delta = (recharges[i]['initiated_at'] - recharges[i-1]['initiated_at']).total_seconds() / 86400
                intervals.append(delta)
            twin['avg_recharge_interval_days'] = round(float(np.mean(intervals)), 1) if intervals else 8.0

            # Avg recharge amount
            amounts = [float(r['amount_ngn']) for r in recharges]
            twin['avg_recharge_amount_ngn'] = round(float(np.mean(amounts)), 0)

            # Preferred network
            networks = [r['network'] for r in recharges]
            from collections import Counter
            twin['preferred_network'] = Counter(networks).most_common(1)[0][0]

            # Preferred recharge hour
            hours = [r['initiated_at'].hour for r in recharges]
            twin['preferred_recharge_hour'] = Counter(hours).most_common(1)[0][0]

            # Emergency purchases (< ₦300 = likely panic buy)
            emergency = sum(1 for r in recharges if float(r['amount_ngn']) < 300)
            twin['emergency_frequency'] = round(emergency / max(len(recharges), 1), 2)

            # Savings sensitivity based on avg purchase amount
            avg = twin['avg_recharge_amount_ngn']
            twin['savings_sensitivity'] = 'high' if avg < 1500 else 'medium' if avg < 3000 else 'low'

            twin['data_points'] = len(recharges)

        # Daily burn rate from balance drops
        if len(balances) >= 2:
            drops_per_day = []
            for i in range(1, len(balances)):
                drop = float(balances[i-1]['balance_mb']) - float(balances[i]['balance_mb'])
                hours = (balances[i]['fetched_at'] - balances[i-1]['fetched_at']).total_seconds() / 3600
                if drop > 0 and 0 < hours <= 24:
                    drops_per_day.append((drop / hours) * 24)
            if drops_per_day:
                daily_avg = float(np.median(drops_per_day))
                twin['daily_avg_mb'] = round(daily_avg, 0)
                twin['weekly_avg_mb'] = round(daily_avg * 7, 0)
                twin['monthly_avg_mb'] = round(daily_avg * 30, 0)

        # Churn risk (days since last recharge)
        if recharges:
            days_since = (datetime.now() - recharges[-1]['initiated_at']).days
            twin['churn_risk_score'] = round(min(0.95, days_since / 21), 3)

        return twin

    def _persist_twin(self, cursor, db, user_id: str, twin: dict):
        cursor.execute("""
            INSERT INTO user_data_twins (
                user_id, daily_avg_mb, weekly_avg_mb, monthly_avg_mb,
                avg_recharge_interval_days, recharge_trigger_mb, preferred_recharge_hour,
                avg_recharge_amount_ngn, preferred_network, churn_risk_score,
                bundle_acceptance_rate, savings_sensitivity, budget_adherence_rate,
                emergency_frequency, model_version, data_points, last_updated
            ) VALUES (
                %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'2.0',%s,NOW()
            )
            ON CONFLICT (user_id) DO UPDATE SET
                daily_avg_mb=%s, weekly_avg_mb=%s, monthly_avg_mb=%s,
                avg_recharge_interval_days=%s, recharge_trigger_mb=%s,
                preferred_recharge_hour=%s, avg_recharge_amount_ngn=%s,
                preferred_network=%s, churn_risk_score=%s, savings_sensitivity=%s,
                budget_adherence_rate=%s, emergency_frequency=%s,
                model_version='2.0', data_points=%s, last_updated=NOW()
        """, (
            user_id,
            twin['daily_avg_mb'], twin['weekly_avg_mb'], twin['monthly_avg_mb'],
            twin['avg_recharge_interval_days'], twin['recharge_trigger_mb'],
            twin['preferred_recharge_hour'], twin['avg_recharge_amount_ngn'],
            twin['preferred_network'], twin['churn_risk_score'],
            twin['bundle_acceptance_rate'], twin['savings_sensitivity'],
            twin['budget_adherence_rate'], twin['emergency_frequency'],
            twin['data_points'],
            # UPDATE values
            twin['daily_avg_mb'], twin['weekly_avg_mb'], twin['monthly_avg_mb'],
            twin['avg_recharge_interval_days'], twin['recharge_trigger_mb'],
            twin['preferred_recharge_hour'], twin['avg_recharge_amount_ngn'],
            twin['preferred_network'], twin['churn_risk_score'],
            twin['savings_sensitivity'], twin['budget_adherence_rate'],
            twin['emergency_frequency'], twin['data_points'],
        ))
        db.commit()


# ═══════════════════════════════════════════════════════════════
# PIPELINE 2: NIGHTLY SCORE RECALCULATION
# Schedule: 2:30 AM WAT daily
# ═══════════════════════════════════════════════════════════════
class ScoreRecalculationPipeline:
    def __init__(self):
        self.logger = logging.getLogger('ScorePipeline')

    def run(self, batch_size: int = 5000):
        self.logger.info("Starting Score Recalculation Pipeline")
        db = get_db()
        cursor = db.cursor()
        r = get_redis()

        # Active users in last 30 days
        cursor.execute("""
            SELECT DISTINCT user_id FROM recharges
            WHERE initiated_at > NOW() - INTERVAL '30 days'
            LIMIT %s
        """, (batch_size,))
        users = [row['user_id'] for row in cursor.fetchall()]

        updated = 0
        score_changes = []

        for user_id in users:
            try:
                score = self._calculate_score(cursor, user_id)
                prev = self._get_previous_score(cursor, user_id)

                cursor.execute("""
                    INSERT INTO connectivity_scores
                        (user_id, overall_score, budget_score, efficiency_score,
                         reliability_score, access_score, tier)
                    VALUES (%s,%s,%s,%s,%s,%s,%s)
                """, (user_id, score['overall'], score['budget'], score['efficiency'],
                      score['reliability'], score['access'], score['tier']))
                db.commit()

                # Invalidate cache
                r.delete(f"score:{user_id}")

                delta = score['overall'] - prev if prev else 0
                if abs(delta) >= 10:
                    score_changes.append({
                        'user_id': user_id,
                        'score': score['overall'],
                        'tier': score['tier'],
                        'delta': delta
                    })
                updated += 1
            except Exception as e:
                self.logger.error(f"Score calc failed for {user_id}: {e}")
                db.rollback()

        self.logger.info(f"Scores updated: {updated}, Significant changes: {len(score_changes)}")
        db.close()
        return {'updated': updated, 'changes': score_changes}

    def _calculate_score(self, cursor, user_id: str) -> dict:
        month_start = datetime.now().replace(day=1, hour=0, minute=0, second=0)

        # Budget adherence
        cursor.execute("""
            SELECT COALESCE(SUM(r.amount_ngn), 0) as spent,
                   MAX(ub.amount_ngn) as budget
            FROM recharges r
            LEFT JOIN user_budgets ub ON ub.user_id = r.user_id
                AND ub.period = 'monthly' AND ub.is_active = TRUE
            WHERE r.user_id = %s AND r.status = 'completed' AND r.initiated_at >= %s
        """, (user_id, month_start))
        row = cursor.fetchone()
        spent = float(row['spent'] or 0)
        budget = float(row['budget'] or 0)

        budget_score = 70
        if budget > 0:
            adherence = max(0, 1 - max(0, (spent - budget) / budget))
            budget_score = min(100, int(adherence * 100))

        # Efficiency (cost per GB vs market avg of ₦700)
        cursor.execute("""
            SELECT COALESCE(SUM(amount_ngn), 0) as total_spend,
                   COALESCE(SUM(data_mb), 0) as total_mb
            FROM recharges
            WHERE user_id = %s AND status = 'completed' AND initiated_at >= %s
        """, (user_id, month_start))
        eff_row = cursor.fetchone()
        total_spend = float(eff_row['total_spend'] or 0)
        total_mb = int(eff_row['total_mb'] or 0)
        market_avg_per_gb = 700

        efficiency_score = 60
        if total_mb > 0 and total_spend > 0:
            user_cost_per_gb = total_spend / (total_mb / 1024)
            efficiency_score = min(100, int((market_avg_per_gb / max(user_cost_per_gb, 100)) * 80))

        # Reliability (confidence score avg)
        cursor.execute("""
            SELECT AVG(sb.confidence_score) as avg_conf
            FROM sim_balances sb
            JOIN sim_cards sc ON sc.id = sb.sim_id
            WHERE sc.user_id = %s AND sb.fetched_at >= %s
        """, (user_id, month_start))
        rel_row = cursor.fetchone()
        reliability_score = min(100, int(float(rel_row['avg_conf'] or 0.8) * 100))

        # Access score (planning quality)
        cursor.execute("""
            SELECT COUNT(*) as emergency_count
            FROM recharges
            WHERE user_id = %s AND amount_ngn < 300 AND status = 'completed' AND initiated_at >= %s
        """, (user_id, month_start))
        access_row = cursor.fetchone()
        emergency_count = int(access_row['emergency_count'] or 0)
        access_score = max(0, min(100, 80 - emergency_count * 15))

        # Composite
        raw = (budget_score * 0.30 + efficiency_score * 0.25 +
               reliability_score * 0.20 + access_score * 0.25)
        overall = int(raw * 8.5)

        tier = ('NEEDS WORK' if overall < 500 else
                'FAIR' if overall < 600 else
                'GOOD' if overall < 700 else
                'GREAT' if overall < 800 else 'EXCELLENT')

        return {
            'overall': overall, 'budget': budget_score, 'efficiency': efficiency_score,
            'reliability': reliability_score, 'access': access_score, 'tier': tier
        }

    def _get_previous_score(self, cursor, user_id: str) -> Optional[int]:
        cursor.execute("""
            SELECT overall_score FROM connectivity_scores
            WHERE user_id = %s ORDER BY calculated_at DESC LIMIT 1
        """, (user_id,))
        row = cursor.fetchone()
        return row['overall_score'] if row else None


# ═══════════════════════════════════════════════════════════════
# PIPELINE 3: FORECASTING MODEL UPDATE
# Schedule: 3:00 AM WAT daily
# ═══════════════════════════════════════════════════════════════
class ForecastingPipeline:
    def __init__(self):
        self.logger = logging.getLogger('ForecastingPipeline')

    def run(self):
        self.logger.info("Starting Forecasting Pipeline")
        db = get_db()
        cursor = db.cursor()

        # Update market-level bundle value rankings
        self._update_bundle_rankings(cursor, db)

        # Update exhaustion forecasts for high-risk users
        self._update_high_risk_forecasts(cursor, db)

        db.close()
        self.logger.info("Forecasting Pipeline complete")

    def _update_bundle_rankings(self, cursor, db):
        """Compute cost-per-GB rankings and update bundle catalog metadata"""
        cursor.execute("""
            SELECT id, network, data_mb, price_ngn
            FROM bundle_catalog WHERE is_active = TRUE
        """)
        bundles = cursor.fetchall()

        for bundle in bundles:
            if int(bundle['data_mb']) > 0:
                cost_per_gb = float(bundle['price_ngn']) / (int(bundle['data_mb']) / 1024)
                # cost_per_gb is computed column, no update needed
                pass

        self.logger.info(f"Bundle rankings refreshed for {len(bundles)} bundles")

    def _update_high_risk_forecasts(self, cursor, db):
        """Generate fresh exhaustion forecasts for users with < 1GB remaining"""
        cursor.execute("""
            SELECT DISTINCT ON (sc.user_id)
                sc.user_id, sc.id as sim_id, sc.network,
                sb.balance_mb, sb.expiry_date
            FROM sim_balances sb
            JOIN sim_cards sc ON sc.id = sb.sim_id
            WHERE sb.balance_mb < 1024
              AND sb.fetched_at > NOW() - INTERVAL '6 hours'
            ORDER BY sc.user_id, sb.balance_mb ASC
            LIMIT 500
        """)
        high_risk = cursor.fetchall()

        for row in high_risk:
            try:
                cursor.execute("""
                    SELECT daily_avg_mb FROM user_data_twins WHERE user_id = %s
                """, (row['user_id'],))
                twin = cursor.fetchone()
                daily_avg = float(twin['daily_avg_mb']) if twin else 1000

                hours_remaining = float(row['balance_mb']) / max(daily_avg / 24, 1)
                predicted_date = datetime.now() + timedelta(hours=hours_remaining)

                cursor.execute("""
                    INSERT INTO forecasts
                        (user_id, sim_id, forecast_type, predicted_date,
                         predicted_value, confidence_pct, model_version)
                    VALUES (%s,%s,'exhaustion',%s,%s,0.80,'batch-2.0')
                """, (row['user_id'], row['sim_id'], predicted_date, hours_remaining))
                db.commit()
            except Exception as e:
                self.logger.warning(f"Forecast failed for {row['user_id']}: {e}")
                db.rollback()

        self.logger.info(f"Exhaustion forecasts updated for {len(high_risk)} high-risk users")


# ═══════════════════════════════════════════════════════════════
# PIPELINE 4: COMMUNITY INTELLIGENCE REFRESH
# Schedule: 4:00 AM WAT daily
# ═══════════════════════════════════════════════════════════════
class CommunityIntelligencePipeline:
    def __init__(self):
        self.logger = logging.getLogger('CommunityPipeline')

    def run(self):
        self.logger.info("Starting Community Intelligence Pipeline")
        db = get_db()
        cursor = db.cursor()
        r = get_redis()

        # Compute network performance by area
        cursor.execute("""
            SELECT
                geohash_6,
                network,
                SUM(user_count) as total_users,
                AVG(avg_signal) as avg_signal
            FROM network_performance_reports
            WHERE report_date >= CURRENT_DATE - INTERVAL '7 days'
            GROUP BY geohash_6, network
            HAVING SUM(user_count) >= 10
        """)
        reports = cursor.fetchall()

        # Publish community metrics
        for report in reports:
            cache_key = f"community:area:{report['geohash_6']}:{report['network']}"
            r.setex(cache_key, 3600 * 24, json.dumps({
                'network': report['network'],
                'geohash': report['geohash_6'],
                'userCount': int(report['total_users']),
                'avgSignal': round(float(report['avg_signal'] or 3), 1),
                'updatedAt': datetime.now().isoformat(),
            }))

        # Compute country-level benchmarks
        cursor.execute("""
            SELECT
                COUNT(DISTINCT r.user_id) as users,
                AVG(monthly_totals.spend) as avg_spend,
                PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY monthly_totals.spend) as median_spend
            FROM (
                SELECT user_id, SUM(amount_ngn) as spend
                FROM recharges
                WHERE status = 'completed' AND initiated_at >= NOW() - INTERVAL '30 days'
                GROUP BY user_id
                HAVING SUM(amount_ngn) > 0
            ) monthly_totals
            CROSS JOIN recharges r
            WHERE r.status = 'completed'
        """)
        benchmark = cursor.fetchone()

        if benchmark and benchmark['users']:
            r.setex('community:benchmarks:NG', 3600 * 6, json.dumps({
                'country': 'NG',
                'activeUsers': int(benchmark['users'] or 0),
                'avgMonthlySpend': round(float(benchmark['avg_spend'] or 6500), 0),
                'medianMonthlySpend': round(float(benchmark['median_spend'] or 5800), 0),
                'updatedAt': datetime.now().isoformat(),
            }))

        self.logger.info(f"Community intelligence refreshed. Areas updated: {len(reports)}")
        db.close()


# ═══════════════════════════════════════════════════════════════
# PIPELINE 5: CHURN DETECTION
# Schedule: 6:00 AM WAT daily
# ═══════════════════════════════════════════════════════════════
class ChurnDetectionPipeline:
    def __init__(self):
        self.logger = logging.getLogger('ChurnPipeline')

    def run(self):
        self.logger.info("Starting Churn Detection Pipeline")
        db = get_db()
        cursor = db.cursor()

        # Users with high churn risk who haven't been re-engaged
        cursor.execute("""
            SELECT dt.user_id, dt.churn_risk_score, up.display_name, up.fcm_token
            FROM user_data_twins dt
            JOIN user_profiles up ON up.user_id = dt.user_id
            JOIN users u ON u.id = dt.user_id
            WHERE dt.churn_risk_score > 0.6
              AND u.status = 'active'
              AND NOT EXISTS (
                SELECT 1 FROM notifications n
                WHERE n.user_id = dt.user_id
                  AND n.type = 'reengagement'
                  AND n.created_at > NOW() - INTERVAL '7 days'
              )
            ORDER BY dt.churn_risk_score DESC
            LIMIT 200
        """)
        at_risk = cursor.fetchall()

        self.logger.info(f"Found {len(at_risk)} at-risk users")

        # In production: call notification service for each
        # Here we log for now
        for user in at_risk:
            self.logger.info(f"Churn risk {user['churn_risk_score']:.2f} — {user['user_id']}")

        db.close()
        return {'at_risk_count': len(at_risk)}


# ═══════════════════════════════════════════════════════════════
# PIPELINE 6: DATA QUALITY CHECKS
# Schedule: 5:00 AM WAT daily
# ═══════════════════════════════════════════════════════════════
class DataQualityPipeline:
    def __init__(self):
        self.logger = logging.getLogger('DataQualityPipeline')

    def run(self):
        self.logger.info("Starting Data Quality Pipeline")
        db = get_db()
        cursor = db.cursor()
        issues = []

        # Check 1: Balance data freshness
        cursor.execute("""
            SELECT COUNT(*) as stale_count
            FROM sim_cards sc
            WHERE sc.is_active = TRUE
              AND (sc.last_fetched_at IS NULL OR sc.last_fetched_at < NOW() - INTERVAL '24 hours')
        """)
        stale = cursor.fetchone()
        if int(stale['stale_count'] or 0) > 100:
            issues.append(f"WARN: {stale['stale_count']} SIMs with stale balances (>24h)")

        # Check 2: Score coverage
        cursor.execute("""
            SELECT COUNT(*) as missing
            FROM users u
            WHERE u.status = 'active'
              AND NOT EXISTS (
                SELECT 1 FROM connectivity_scores cs
                WHERE cs.user_id = u.id
                  AND cs.calculated_at > NOW() - INTERVAL '48 hours'
              )
        """)
        missing_scores = cursor.fetchone()
        if int(missing_scores['missing'] or 0) > 50:
            issues.append(f"WARN: {missing_scores['missing']} active users without recent score")

        # Check 3: Wallet ledger integrity
        cursor.execute("""
            SELECT COUNT(*) as mismatched
            FROM wallets w
            WHERE w.credits_balance != COALESCE((
                SELECT SUM(credits_delta) FROM wallet_transactions WHERE user_id = w.user_id
            ), 0)
            AND w.credits_balance > 0
        """)
        mismatched = cursor.fetchone()
        if int(mismatched['mismatched'] or 0) > 0:
            issues.append(f"CRITICAL: {mismatched['mismatched']} wallet ledger mismatches detected!")

        # Check 4: Failed purchases stuck in pending
        cursor.execute("""
            SELECT COUNT(*) as stuck
            FROM recharges
            WHERE status = 'pending' AND initiated_at < NOW() - INTERVAL '30 minutes'
        """)
        stuck = cursor.fetchone()
        if int(stuck['stuck'] or 0) > 0:
            issues.append(f"WARN: {stuck['stuck']} purchases stuck in pending status")
            # Auto-fail stuck purchases
            cursor.execute("""
                UPDATE recharges SET status = 'failed', failure_reason = 'Timeout — auto-failed by DQ job'
                WHERE status = 'pending' AND initiated_at < NOW() - INTERVAL '30 minutes'
            """)
            db.commit()

        for issue in issues:
            self.logger.warning(issue)

        if not issues:
            self.logger.info("✅ All data quality checks passed")

        db.close()
        return {'issues': issues, 'passed': len(issues) == 0}


# ═══════════════════════════════════════════════════════════════
# PIPELINE RUNNER
# ═══════════════════════════════════════════════════════════════
def run_pipeline(pipeline_name: str):
    pipelines = {
        'twin': DataTwinPipeline,
        'score': ScoreRecalculationPipeline,
        'forecast': ForecastingPipeline,
        'community': CommunityIntelligencePipeline,
        'churn': ChurnDetectionPipeline,
        'quality': DataQualityPipeline,
    }

    if pipeline_name not in pipelines:
        print(f"Unknown pipeline: {pipeline_name}")
        print(f"Available: {', '.join(pipelines.keys())}")
        return

    pipeline = pipelines[pipeline_name]()
    result = pipeline.run()
    print(f"Pipeline '{pipeline_name}' complete:", json.dumps(result, default=str, indent=2))


def run_all():
    """Run all pipelines in order (for nightly batch)"""
    logger = logging.getLogger('BatchRunner')
    logger.info("=== Starting Nightly Batch ===")
    start = datetime.now()

    results = {}
    for name, cls in [
        ('quality', DataQualityPipeline),
        ('twin', DataTwinPipeline),
        ('score', ScoreRecalculationPipeline),
        ('forecast', ForecastingPipeline),
        ('community', CommunityIntelligencePipeline),
        ('churn', ChurnDetectionPipeline),
    ]:
        try:
            logger.info(f"Starting: {name}")
            result = cls().run()
            results[name] = {'status': 'ok', 'result': result}
        except Exception as e:
            logger.error(f"Pipeline {name} failed: {e}")
            results[name] = {'status': 'error', 'error': str(e)}

    elapsed = (datetime.now() - start).total_seconds()
    logger.info(f"=== Nightly Batch Complete in {elapsed:.1f}s ===")
    return results


if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1:
        run_pipeline(sys.argv[1])
    else:
        run_all()

FROM node:20-alpine

RUN apk add --no-cache tini

WORKDIR /app

# shared is bundled inside this service folder
COPY shared/ ./shared/

COPY package.json ./package.json
COPY src/ ./src/

RUN npm install --omit=dev --no-audit --no-fund

RUN addgroup -g 1001 -S dataos && adduser -u 1001 -S dataos -G dataos
RUN chown -R dataos:dataos /app
USER dataos

EXPOSE 3002

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]

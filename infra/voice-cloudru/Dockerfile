ARG NODE_IMAGE
FROM ${NODE_IMAGE}
WORKDIR /app
COPY services/voice-api/package.json services/voice-api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY services/voice-api/server.mjs services/voice-api/gis-service.mjs ./
USER node
ENV NODE_ENV=production PORT=8080
CMD ["node", "server.mjs"]

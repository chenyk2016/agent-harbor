ARG APP_NODE_BASE
FROM ${APP_NODE_BASE}
WORKDIR /app
COPY --chown=node:node . /app
USER node
ENTRYPOINT ["node", "/app/harbor-runtime.mjs"]

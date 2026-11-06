ARG APP_NODE_BASE
FROM ${APP_NODE_BASE}
LABEL harbor.app.runtime-access="v1"
WORKDIR /app
COPY --chown=node:node . /app
USER node
ENTRYPOINT ["node", "/app/harbor-runtime.mjs"]

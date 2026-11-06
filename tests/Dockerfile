FROM agent-harbor:0.4.0
COPY dist/tests/docker-worker.js dist/tests/policy-probe.js /platform/runtime/dist/tests/
ENTRYPOINT ["node", "/platform/runtime/dist/tests/docker-worker.js"]

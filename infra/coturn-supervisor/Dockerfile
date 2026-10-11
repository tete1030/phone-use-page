ARG COTURN_IMAGE=coturn/coturn:4.8.0-r0@sha256:5de3fc6be2da60c3d93f40aa57e0f43188d9183c0053b25581883f5ccd252bdb
FROM ${COTURN_IMAGE} AS prepared
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY supervisor.py /opt/coturn-supervisor/supervisor.py
ENV PYTHONDONTWRITEBYTECODE=1 TURN_STATE_DIR=/var/lib/coturn-supervisor

FROM prepared AS verify
COPY test_supervisor.py /tests/test_supervisor.py
RUN python3 -m unittest discover -s /tests -p 'test_*.py' \
    && printf 'verified\n' > /tmp/supervisor-verified

FROM prepared AS runtime
COPY --from=verify /tmp/supervisor-verified /usr/local/share/coturn-supervisor-verified
USER nobody:nogroup
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python3", "/opt/coturn-supervisor/supervisor.py", "status"]
ENTRYPOINT ["python3", "/opt/coturn-supervisor/supervisor.py"]
CMD ["run"]

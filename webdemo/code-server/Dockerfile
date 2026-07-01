FROM codercom/code-server:latest

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
  rsync \
  git \
  curl \
  ca-certificates \
  nodejs \
  npm \
  && rm -rf /var/lib/apt/lists/*

COPY ./demo-project /template-project
COPY ./code-server/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
  && mkdir -p /workspace \
  && chown -R coder:coder /workspace /template-project /entrypoint.sh

USER coder

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]

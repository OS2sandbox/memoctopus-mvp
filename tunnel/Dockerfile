# Tiny SSH-forwarding sidecar: holds an autossh tunnel to a remote host so other
# compose services can reach a service that's only bound to that host's loopback
# (e.g. the GPU box's diarization on 127.0.0.1:5000). Used by docker-compose.tunnel.yml.
FROM alpine:3.20
RUN apk add --no-cache autossh openssh-client
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]

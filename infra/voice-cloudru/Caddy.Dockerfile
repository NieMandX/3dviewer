ARG CADDY_IMAGE
FROM ${CADDY_IMAGE}
# The staging listener is unprivileged; retain cap_drop ALL at runtime.
RUN setcap -r /usr/bin/caddy

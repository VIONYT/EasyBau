# syntax=docker/dockerfile:1.7
# Backup service (ADR 0005, 0011): the PostgreSQL client tools of the database image plus restic
# for the optional encrypted backup off site (and an SSH client for sftp: targets). The script
# itself is mounted from infra/backup.

FROM postgres:17-alpine AS runtime
# Optional extra CA for TLS-inspecting proxies during the build (build secret "extra_ca"): only
# for apk, the original CA bundle is put back afterwards.
RUN --mount=type=secret,id=extra_ca \
    bundle=/etc/ssl/cert.pem \
 && if [ -s /run/secrets/extra_ca ]; then cp "$bundle" /tmp/cert.pem.orig && cat /run/secrets/extra_ca >> "$bundle"; fi \
 && apk add --no-cache restic openssh-client-default \
 && if [ -f /tmp/cert.pem.orig ]; then mv /tmp/cert.pem.orig "$bundle"; fi \
 && restic version

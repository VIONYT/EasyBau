# syntax=docker/dockerfile:1.7
# FORMER Belegarchiv (ADR 0008, replaced by RustFS in ADR 0009): MinIO Community is archived since
# 25.04.2026 and gets no security fixes. Only for moving existing archives (compose profile
# "legacy-minio", read as ARCHIVE_PREVIOUS_S3_*), never as the active archive. Built from the
# official source (AGPL-3.0) of the last community release.
ARG MINIO_RELEASE=RELEASE.2025-10-15T17-29-55Z
ARG MINIO_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a

FROM golang:1.24-alpine AS build
ARG MINIO_RELEASE
ARG MINIO_COMMIT
ADD https://github.com/minio/minio.git#${MINIO_COMMIT} /src
WORKDIR /src
ENV CGO_ENABLED=0 GOFLAGS="-trimpath -mod=readonly -buildvcs=false"
# Optional extra CA for TLS-inspecting proxies (build secret "extra_ca", may be empty).
# -p 2 keeps the compiler's memory moderate on small servers.
RUN --mount=type=secret,id=extra_ca --mount=type=cache,id=gomod,target=/go/pkg/mod \
    --mount=type=cache,id=gobuild,target=/root/.cache/go-build \
    if [ -s /run/secrets/extra_ca ]; then cat /run/secrets/extra_ca >> /etc/ssl/certs/ca-certificates.crt; fi \
 && version="$(echo "${MINIO_RELEASE#RELEASE.}" | sed -E 's/T([0-9]{2})-([0-9]{2})-([0-9]{2})Z/T\1:\2:\3Z/')" \
 && go build -p 2 -tags kqueue -o /out/minio -ldflags "-s -w \
      -X github.com/minio/minio/cmd.Version=${version} \
      -X github.com/minio/minio/cmd.ReleaseTag=${MINIO_RELEASE} \
      -X github.com/minio/minio/cmd.CommitID=${MINIO_COMMIT}" .

FROM alpine:3.22 AS runtime
# The Alpine base image already contains the CA bundle; no package installation needed.
RUN adduser -S -H -u 10001 minio && mkdir -p /data && chown minio /data
COPY --from=build /out/minio /usr/local/bin/minio
USER minio
EXPOSE 9000
ENV MINIO_BROWSER=off MINIO_UPDATE=off
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=10 \
  CMD wget -q -O /dev/null http://127.0.0.1:9000/minio/health/live || exit 1
ENTRYPOINT ["minio", "server", "/data", "--address", ":9000", "--quiet"]

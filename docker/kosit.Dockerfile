# syntax=docker/dockerfile:1.7
# KoSIT-Validator (ADR 0007): checks every e-invoice (XRechnung UBL, ZUGFeRD/Factur-X CII) before it is
# archived or sent. Runs as an internal HTTP daemon: POST the XML to / -> 200 acceptable, 406 rejected,
# body = validation report. Versions and checksums are pinned; update both together.
ARG VALIDATOR_VERSION=1.6.3
ARG CONFIG_RELEASE=2026-08-31
ARG XRECHNUNG_VERSION=3.0.2

FROM alpine:3.22 AS download
ARG VALIDATOR_VERSION
ARG CONFIG_RELEASE
ARG XRECHNUNG_VERSION
# Apache-2.0: https://github.com/itplr-kosit/validator, https://github.com/itplr-kosit/validator-configuration-xrechnung
ADD --checksum=sha256:799e64befca97d4080e03608c80b85dd5a5ecc5f4ae4f35d1116ec2855b9a7c9 \
    https://github.com/itplr-kosit/validator/releases/download/v${VALIDATOR_VERSION}/validator-${VALIDATOR_VERSION}-standalone.jar \
    /opt/kosit/validator.jar
ADD --checksum=sha256:2530cd107c414511c5d0462ec10f886910395abfca820db82e83d70bf01221a8 \
    https://github.com/itplr-kosit/validator-configuration-xrechnung/releases/download/v${CONFIG_RELEASE}/xrechnung-${XRECHNUNG_VERSION}-validator-configuration-${CONFIG_RELEASE}.zip \
    /tmp/configuration.zip
RUN mkdir -p /opt/kosit/configuration \
 && unzip -q /tmp/configuration.zip -d /opt/kosit/configuration \
 && rm /tmp/configuration.zip \
 && chmod -R a+rX /opt/kosit

FROM eclipse-temurin:21-jre-alpine AS runtime
COPY --from=download /opt/kosit /opt/kosit
RUN addgroup -S kosit && adduser -S -G kosit -H kosit
USER kosit
WORKDIR /opt/kosit
EXPOSE 8080
# Small, predictable footprint for the compact profile (ADR 0002/0007).
ENV JAVA_TOOL_OPTIONS="-Xmx256m -Xss512k -XX:+UseSerialGC -XX:MaxMetaspaceSize=128m -XX:TieredStopAtLevel=1"
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=10 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/server/health || exit 1
ENTRYPOINT ["java", "-jar", "/opt/kosit/validator.jar", \
  "--scenarios", "/opt/kosit/configuration/scenarios.xml", \
  "--repository", "/opt/kosit/configuration", \
  "--daemon", "--host", "0.0.0.0", "--port", "8080"]

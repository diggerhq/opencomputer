# Xray (VLESS+REALITY) supervised by egress.py, which applies policy changes
# live through Xray's API. Changing the Xray version: update the tag and
# checksum (Xray-linux-64.zip.dgst on the release) and re-run the tests.
FROM python:3.13-alpine
ARG XRAY_VERSION=26.3.27
ARG XRAY_SHA256=23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae
RUN wget -qO /tmp/xray.zip "https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/Xray-linux-64.zip" \
 && echo "${XRAY_SHA256}  /tmp/xray.zip" | sha256sum -c - \
 && unzip -q /tmp/xray.zip xray -d /usr/local/bin && rm /tmp/xray.zip
COPY egress.py /egress/
ENTRYPOINT ["python3", "-u", "/egress/egress.py", "run"]

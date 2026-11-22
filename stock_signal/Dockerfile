ARG BUILD_FROM=ghcr.io/home-assistant/base:3.21
FROM $BUILD_FROM

RUN apk add --no-cache \
    python3 \
    py3-pip \
    py3-wheel \
    gcc \
    musl-dev \
    python3-dev \
    libffi-dev

COPY requirements.txt /tmp/
RUN pip3 install --no-cache-dir --break-system-packages -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

COPY rootfs /

RUN chmod a+x /run.sh /app/main.py \
    && chmod -R a+r /app/static

WORKDIR /data

CMD [ "/run.sh" ]

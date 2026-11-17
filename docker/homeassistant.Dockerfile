# The Home Assistant add-on image: BicuSlicer's image, with ingress (Home Assistant's sidebar) on, running as root
# because Home Assistant gives add-ons a root-owned /data. Built by .github/workflows/docker.yml after the main image:
#
#   docker build -f docker/homeassistant.Dockerfile --build-arg BASE=ghcr.io/<owner>/bicuslicer:<version> .
ARG BASE=ghcr.io/kylefutter97-prog/bicuslicer:latest
FROM ${BASE}
USER root
ENV INGRESS=1 \
    DATA_DIR=/data
LABEL io.hass.type="addon" \
      io.hass.name="BicuSlicer" \
      io.hass.description="Slice for your 3D printer in the browser, with OrcaSlicer's engine"

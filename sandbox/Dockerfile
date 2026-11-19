ARG BASE_IMAGE=python:3.13-slim-bookworm@sha256:a5a7017efc5969e00ae2b91c8eb0631049a569652aa4ffc4501769049ae45c72
FROM ${BASE_IMAGE}
ARG DEBIAN_MIRROR=https://deb.debian.org
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN python -c "from pathlib import Path; import sys; p=Path('/etc/apt/sources.list.d/debian.sources'); s=p.read_text().replace('http://deb.debian.org',sys.argv[1]).replace('https://deb.debian.org',sys.argv[1]); p.write_text(s)" "${DEBIAN_MIRROR}" \
    && apt-get update \
    && apt-get install -y --no-install-recommends fontconfig fonts-noto-cjk=1:20220127+repack1-1 \
    && rm -rf /var/lib/apt/lists/*
COPY sandbox/requirements.lock /opt/evoscholar/requirements.lock
RUN python -m pip install --no-cache-dir --index-url "${PIP_INDEX_URL}" -r /opt/evoscholar/requirements.lock
COPY python/evoscholar_*.py /opt/evoscholar/python/
COPY rulepacks/figures/*.yaml /opt/evoscholar/rulepacks/figures/
COPY rulepacks/writing/*.yaml /opt/evoscholar/rulepacks/writing/
COPY sandbox/matplotlibrc sandbox/probe.py /opt/evoscholar/
ENV MPLBACKEND=Agg MATPLOTLIBRC=/opt/evoscholar/matplotlibrc PYTHONPATH=/opt/evoscholar/python
USER 65532:65532
WORKDIR /work

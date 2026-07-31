FROM mcr.microsoft.com/playwright:v1.49.0-jammy

ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV HTTP_PROXY=$HTTP_PROXY HTTPS_PROXY=$HTTPS_PROXY

RUN apt-get update && apt-get install -y --no-install-recommends python3-pip     && pip3 install --no-cache-dir curl_cffi     && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV HTTP_PROXY= HTTPS_PROXY=

WORKDIR /app
ENV NODE_ENV=production PORT=3456 PYTHON_BIN=python3

COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public
COPY config ./config
COPY data ./data
COPY cffetch.py ./
RUN mkdir -p accounts cards addresses payment-tasks out

EXPOSE 3456
CMD ["node", "src/server.js"]

# syntax=docker/dockerfile:1

# Landing page de Openwhispr — sub-app Vite dentro del monorepo Electron.
# Reusa el package.json/lockfile de la raiz (react, vite, plugin-react ya viven ahi).
# Este Dockerfile se construye con contexto = raiz del repo (ver docker-compose.yml).

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts: evita el postinstall (electron-rebuild) que no aplica aqui
# y evitaria descargar Electron solo para compilar la landing estatica.
RUN npm ci --ignore-scripts

COPY landing ./landing
RUN npx vite build --config landing/vite.config.ts

FROM nginx:1.27-alpine
COPY --from=build /app/landing/dist /usr/share/nginx/html
COPY landing/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

FROM nginx:1.27.3

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy

ENV HTTP_PROXY=$HTTP_PROXY \
	HTTPS_PROXY=$HTTPS_PROXY \
	NO_PROXY=$NO_PROXY \
	http_proxy=$HTTP_PROXY \
	https_proxy=$HTTPS_PROXY \
	no_proxy=$NO_PROXY

RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d
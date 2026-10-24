# Changelog

All notable changes to OpenBinding are recorded here, newest first, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

### Changed

- The gateway now refuses to start when `PUBLIC_BASE_URL`, `FRONTEND_URL` or an entry of `CORS_ALLOW_ORIGINS` is not a well-formed `scheme://host[:port]` origin (path, wildcard inside an entry, comma, missing scheme, userinfo), naming the variable and the offending value.

# Changelog

## [0.2.2](https://github.com/chrischall/iaqualink-mcp/compare/v0.2.1...v0.2.2) (2026-10-17)


### Bug Fixes

* **security:** scrub the password and session tokens before truncating upstream text ([#13](https://github.com/chrischall/iaqualink-mcp/issues/13)) ([80e7dac](https://github.com/chrischall/iaqualink-mcp/commit/80e7dac1a530c33e5816cf1cf287064e09ff075c))

## [0.2.1](https://github.com/chrischall/iaqualink-mcp/compare/v0.2.0...v0.2.1) (2026-10-16)


### Bug Fixes

* **control:** report a dropped or timed-out write as outcome unknown, via createApiClient ([#9](https://github.com/chrischall/iaqualink-mcp/issues/9)) ([84f69e4](https://github.com/chrischall/iaqualink-mcp/commit/84f69e4234fc469453c0eea1a1b22af751263ee6))

## [0.2.0](https://github.com/chrischall/iaqualink-mcp/compare/v0.1.0...v0.2.0) (2026-10-12)


### Features

* **panel:** check the RS panel and control variable-speed pump speeds ([#8](https://github.com/chrischall/iaqualink-mcp/issues/8)) ([a1cfa84](https://github.com/chrischall/iaqualink-mcp/commit/a1cfa843a13c6acca982c2a89ebff23aae409989))
* **webtouch:** read and edit RS panel schedules and OneTouch scenes ([#5](https://github.com/chrischall/iaqualink-mcp/issues/5)) ([2baa8e2](https://github.com/chrischall/iaqualink-mcp/commit/2baa8e262165459625cc90404ff06ecffe186373))

## 0.1.0 (2026-10-12)


### Features

* iAqualink pool status and equipment control ([#1](https://github.com/chrischall/iaqualink-mcp/issues/1)) ([fb89d8d](https://github.com/chrischall/iaqualink-mcp/commit/fb89d8dfb299e8fd80ae3fa4fa5f352eae67aa27))


### Bug Fixes

* **auth:** never retry a login the server refused with 403 ([#4](https://github.com/chrischall/iaqualink-mcp/issues/4)) ([561fc41](https://github.com/chrischall/iaqualink-mcp/commit/561fc410dcfb640bfacabade62ab8d1bb485af84))

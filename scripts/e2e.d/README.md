# Extra e2e scenarios

Each `<name>.sh` here is sourced by `scripts/e2e.sh` and must define `scenario_<name>`. Use
names without dashes. Helpers available: `log`, `wait_http`, `smoke`, `start_bg`, `service_env`,
`fresh_database`, and the arrays `PIDS`, `CONTAINERS` and `COMPOSE_PROJECTS` (`"<compose file>|<project>"`)
for cleanup. `$ROOT` is the
repo root and `$WORK` a scratch directory removed at exit.

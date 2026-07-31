# TimeFlow

## Pull request web previews

The preview workflow deploys branches from this repository and comments with
their Pages URL. Pull requests from forks are intentionally limited to a
read-only explanation job: running fork code with the write credentials needed
to update `gh-pages` and post comments would expose repository privileges to
untrusted changes. Maintainers can create a trusted same-repository branch when
a fork contribution needs an interactive preview.

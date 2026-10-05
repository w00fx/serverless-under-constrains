#!/bin/sh
# CDK_DOCKER sentinel (design CF V-10, RK-11): aws-cdk-lib runs `$CDK_DOCKER` instead of
# `docker`, so any accidental Docker bundling fails the synthesis that attempted it.
echo "docker-forbidden: Docker was invoked with arguments: $*; study assemblies must bundle with local esbuild" >&2
exit 1

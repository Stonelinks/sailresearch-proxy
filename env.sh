#!/bin/bash

if [ "$0" = "$BASH_SOURCE" ]; then
	echo "This script must be sourced, not executed."
	exit 1
fi

PROJECT_ROOT=$(pwd)
export PROJECT_ROOT

export DATABASE_URL="file:$PROJECT_ROOT/data/proxy.db"

chmod +x $PROJECT_ROOT/bin/* 2>/dev/null
PATH=$PROJECT_ROOT/bin:$PATH
PATH=$PROJECT_ROOT/node_modules/.bin:$PATH
export PATH

if [ -f secrets.sh ]; then
	source secrets.sh
fi

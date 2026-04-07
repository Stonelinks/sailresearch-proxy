#!/bin/bash

# Source this file, don't execute it
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
	echo "This script should be sourced, not executed."
	echo "Usage: source env.sh"
	exit 1
fi

export PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Database
export DATABASE_URL="${DATABASE_URL:-file:$PROJECT_ROOT/data/proxy.db}"

# Make all bin scripts executable and add to PATH
chmod +x "$PROJECT_ROOT/bin/"* 2>/dev/null || true
export PATH="$PROJECT_ROOT/bin:$PROJECT_ROOT/node_modules/.bin:$PATH"

# Source secrets if present
if [ -f "$PROJECT_ROOT/secrets.sh" ]; then
	source "$PROJECT_ROOT/secrets.sh"
fi

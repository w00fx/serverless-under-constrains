# Repository verification interface. Study 1 npm scripts stay the source
# for lint/typecheck/test/golden-fixtures/coverage/mutation. This file
# only names the harness contract.

STUDY1 := study-1
GITLEAKS_VERSION := 8.30.1
export GITLEAKS_VERSION

.PHONY: bootstrap check check-study-1 lint typecheck test coverage \
	golden golden-mutation mutation-study-1 fuzz-study-1 \
	complexity duplication secrets security build check-e2e race metrics \
	metrics-update

bootstrap:
	bash scripts/bootstrap.sh

check: check-study-1

check-study-1:
	cd $(STUDY1) && npm run check

lint:
	cd $(STUDY1) && npm run lint

typecheck:
	cd $(STUDY1) && npm run typecheck

test:
	cd $(STUDY1) && npm test

coverage:
	cd $(STUDY1) && npm run coverage

golden:
	cd $(STUDY1) && npm run golden
	cd $(STUDY1) && npm run golden-tables

golden-mutation:
	bash scripts/golden-mutation.sh

mutation-study-1:
	cd $(STUDY1) && npm run mutation

fuzz-study-1:
	cd $(STUDY1) && npm run fuzz

complexity:
	cd $(STUDY1) && npx eslint src/protocol-records src/controlled-provider src/coordination --rule 'complexity: [error, 23]' --max-warnings 0

duplication:
	node study-1/scripts/duplication.mjs

secrets:
	bash scripts/gitleaks.sh

security:
	cd $(STUDY1) && npm audit --audit-level=high

build:
	cd $(STUDY1) && npm run typecheck

check-e2e:
	@echo "N/A: no browser or UI surface in this repository"
	@exit 0

race:
	@echo "N/A: Node.js/TypeScript has no go-test-race equivalent"
	@exit 0

metrics:
	node scripts/metrics.mjs

metrics-update:
	node scripts/metrics.mjs --update

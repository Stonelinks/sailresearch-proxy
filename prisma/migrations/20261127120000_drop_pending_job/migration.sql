-- PendingJob belonged to the batching machinery removed before the
-- thin-proxy baseline. The baseline never creates it, so it exists only on
-- databases provisioned before the squash; IF EXISTS keeps fresh databases
-- working. Dropping it does not shrink the file: run VACUUM afterwards.
DROP TABLE IF EXISTS "PendingJob";

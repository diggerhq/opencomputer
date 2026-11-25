-- Which organizations use a GitHub installation for Work (tracks and threads,
-- spec 40.9): a pull_request or check_suite webhook names only the
-- installation, and Org.acceptPull is called for each organization here.
-- Written when an organization chooses its Work repository.
CREATE TABLE github_installation_orgs (
  github_installation_id INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  PRIMARY KEY (github_installation_id, account_id)
);

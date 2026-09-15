-- KYC document submissions (user insert/select own; admin/service full).

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE kyc_submissions TO elloot_app;

ALTER TABLE kyc_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyc_submissions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kyc_submissions_select ON kyc_submissions;
CREATE POLICY kyc_submissions_select ON kyc_submissions FOR SELECT
  USING (
    "userId" = app_current_user_id()
    OR app_is_admin()
    OR app_is_service()
  );

DROP POLICY IF EXISTS kyc_submissions_insert ON kyc_submissions;
CREATE POLICY kyc_submissions_insert ON kyc_submissions FOR INSERT
  WITH CHECK (
    "userId" = app_current_user_id()
    OR app_is_service()
    OR app_is_admin()
  );

DROP POLICY IF EXISTS kyc_submissions_update ON kyc_submissions;
CREATE POLICY kyc_submissions_update ON kyc_submissions FOR UPDATE
  USING (app_is_admin() OR app_is_service())
  WITH CHECK (app_is_admin() OR app_is_service());

DROP POLICY IF EXISTS kyc_submissions_delete ON kyc_submissions;
CREATE POLICY kyc_submissions_delete ON kyc_submissions FOR DELETE
  USING (app_is_admin() OR app_is_service());

require "test_helper"

class SuperAdminConstraintTest < ActionDispatch::IntegrationTest
  test "an expired super admin cookie cannot access Sidekiq" do
    user = users(:sure_support_staff)
    sign_in user
    session_record = Current.session
    session_record.update_columns(created_at: 2.hours.ago, last_activity_at: 2.hours.ago)
    Setting.session_absolute_timeout_minutes = 60

    get "/sidekiq"

    assert_response :not_found
    assert_not Session.exists?(session_record.id)
    assert_predicate cookies[:session_token], :blank?
  end
end

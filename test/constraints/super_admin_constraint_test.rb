require "test_helper"

class SuperAdminConstraintTest < ActionDispatch::IntegrationTest
  test "an expired super admin cookie cannot access Sidekiq" do
    user = users(:sure_support_staff)
    Setting.session_absolute_timeout_minutes = 60

    %w[/sidekiq /sidekiq/queues].each do |path|
      sign_in user
      session_record = Current.session
      session_record.update_columns(created_at: 2.hours.ago, last_activity_at: 2.hours.ago)

      get path

      assert_response :not_found
      assert_not Session.exists?(session_record.id)
      assert_predicate cookies[:session_token], :blank?
    end
  end

  test "a valid super admin can still access Sidekiq" do
    sign_in users(:sure_support_staff)

    get "/sidekiq"

    assert_response :success
    assert_not_predicate cookies[:session_token], :blank?
  end

  test "ordinary admins cannot access Sidekiq and keep their valid session" do
    sign_in users(:family_admin)
    session_record = Current.session

    get "/sidekiq/queues"

    assert_response :not_found
    assert Session.exists?(session_record.id)
    assert_not_predicate cookies[:session_token], :blank?
  end

  test "anonymous requests cannot access Sidekiq" do
    get "/sidekiq"

    assert_response :not_found
  end
end

require "test_helper"

class OauthSessionTimeoutTest < ActionDispatch::IntegrationTest
  test "oauth authorization expires an over-age browser session" do
    oauth_app = Doorkeeper::Application.create!(
      name: "Test API Client",
      redirect_uri: "https://client.example.com/callback",
      scopes: "read"
    )
    user = users(:family_admin)
    sign_in user
    session_record = Current.session
    session_record.update_columns(created_at: 2.hours.ago)
    Setting.session_absolute_timeout_minutes = 60

    get "/oauth/authorize", params: {
      client_id: oauth_app.uid,
      redirect_uri: oauth_app.redirect_uri,
      response_type: "code",
      scope: "read"
    }

    assert_redirected_to new_session_path
    assert_equal I18n.t("sessions.expired"), flash[:alert]
    assert_not Session.exists?(session_record.id)
  end
end

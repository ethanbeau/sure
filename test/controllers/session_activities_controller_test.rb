require "test_helper"

class SessionActivitiesControllerTest < ActionDispatch::IntegrationTest
  test "authenticated activity notification uses server time and returns deadlines" do
    Setting.session_inactivity_timeout_minutes = 15
    Setting.session_absolute_timeout_minutes = nil
    sign_in users(:family_admin)
    session_record = Current.session
    expected_at = 10.minutes.from_now

    travel_to expected_at do
      post session_activity_path, headers: { "X-User-Activity" => "true" }
    end

    assert_response :success
    assert_equal expected_at.change(usec: 0), session_record.reload.last_activity_at
    deadlines = response.parsed_body
    expected_server_now = expected_at.change(usec: 0)
    assert_equal expected_server_now.iso8601(3), deadlines.fetch("server_now")
    assert_equal (expected_server_now + 15.minutes).iso8601(3), deadlines.fetch("inactivity_deadline")
    assert_nil deadlines.fetch("absolute_deadline")
  end

  test "timeout deadline checks do not extend inactivity" do
    Setting.session_inactivity_timeout_minutes = 15
    Setting.session_absolute_timeout_minutes = nil
    sign_in users(:family_admin)
    session_record = Current.session
    original_activity_at = session_record.last_activity_at

    travel 5.minutes do
      post session_activity_path, headers: { "Accept" => "application/json" }
    end

    assert_response :success
    assert_equal original_activity_at, session_record.reload.last_activity_at
    assert_equal (original_activity_at + 15.minutes).iso8601(3), response.parsed_body.fetch("inactivity_deadline")
  end

  test "timeout deadline checks revoke an expired session" do
    Setting.session_inactivity_timeout_minutes = 5
    sign_in users(:family_admin)
    session_record = Current.session
    session_record.update_column(:last_activity_at, 10.minutes.ago)

    post session_activity_path, headers: { "Accept" => "application/json" }

    assert_response :unauthorized
    assert_not Session.exists?(session_record.id)
  end

  test "activity requests without a session cookie return unauthorized" do
    post session_activity_path, headers: { "X-User-Activity" => "true" }

    assert_response :unauthorized
  end

  test "another tab's deadline check returns unauthorized after the cookie is cleared" do
    Setting.session_inactivity_timeout_minutes = 5
    sign_in users(:family_admin)
    Current.session.update_column(:last_activity_at, 10.minutes.ago)

    post session_activity_path, headers: { "Accept" => "application/json" }
    assert_response :unauthorized
    assert_predicate cookies[:session_token], :blank?

    post session_activity_path, headers: { "Accept" => "application/json" }
    assert_response :unauthorized
  end

  test "settings pages include activity tracking and deadlines" do
    Setting.session_inactivity_timeout_minutes = 15
    sign_in users(:family_admin)
    session_record = Current.session

    get settings_profile_path

    assert_response :success
    assert_select "body[data-controller~='session-activity'][data-session-activity-url-value]" do |elements|
      assert_includes elements.first["data-action"], "turbo:before-cache@document->session-activity#beforeCache"
      %w[pointerdown click keydown touchstart wheel input change].each do |event|
        assert_includes elements.first["data-action"], "#{event}@document->session-activity#recordActivity:capture:passive"
      end
      assert_includes elements.first["data-action"], "visibilitychange@document->session-activity#handleVisibilityChange"
      assert_includes elements.first["data-action"], "pagehide@window->session-activity#coverForResume"
      %w[pageshow focus].each do |event|
        assert_includes elements.first["data-action"], "#{event}@window->session-activity#resumeFromBackground"
      end
      assert_not_includes elements.first["data-action"], "blur@window"
      assert_equal "false", elements.first["data-session-activity-hide-in-background-value"]
      deadlines = JSON.parse(elements.first["data-session-activity-deadlines-value"])
      assert_equal (session_record.reload.last_activity_at + 15.minutes).iso8601(3), deadlines.fetch("inactivity_deadline")
    end
  end

  test "automatic Turbo navigation does not extend inactivity" do
    sign_in users(:family_admin)
    session_record = Current.session
    original_activity_at = session_record.last_activity_at

    travel 5.minutes do
      get accounts_path, headers: { "Sec-Fetch-Mode" => "cors", "Sec-Fetch-Dest" => "empty" }
    end

    assert_equal original_activity_at, session_record.reload.last_activity_at
  end

  test "XHR polling does not extend inactivity" do
    sign_in users(:family_admin)
    session_record = Current.session
    original_activity_at = session_record.last_activity_at

    get accounts_path, xhr: true

    assert_equal original_activity_at, session_record.reload.last_activity_at
  end

  test "a full-page browser navigation counts activity without JavaScript" do
    sign_in users(:family_admin)
    session_record = Current.session
    original_activity_at = session_record.last_activity_at
    expected_at = 5.minutes.from_now

    travel_to expected_at do
      get accounts_path, headers: { "Sec-Fetch-Mode" => "navigate", "Sec-Fetch-Dest" => "document" }
    end

    assert_equal expected_at.change(usec: 0), session_record.reload.last_activity_at
    refute_equal original_activity_at, session_record.last_activity_at
  end

  test "expired sessions are destroyed and redirected with an expiration message" do
    user = users(:family_admin)
    Setting.session_absolute_timeout_minutes = 60
    sign_in user
    session_record = Current.session
    session_record.update_columns(created_at: 2.hours.ago, last_activity_at: 2.hours.ago)

    get accounts_path

    assert_redirected_to new_session_path
    assert_equal I18n.t("sessions.expired"), flash[:alert]
    assert_not Session.exists?(session_record.id)
  end
end

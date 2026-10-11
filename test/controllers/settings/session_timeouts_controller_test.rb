require "test_helper"

class Settings::SessionTimeoutsControllerTest < ActionDispatch::IntegrationTest
  setup do
    Setting.session_inactivity_timeout_minutes = nil
    Setting.session_absolute_timeout_minutes = nil
  end

  test "super admins can update both timeouts together" do
    with_self_hosting do
      sign_in users(:sure_support_staff)
      patch settings_session_timeouts_path, params: { setting: {
        session_inactivity_timeout_minutes: "15",
        session_absolute_timeout_minutes: "1440"
      } }
      assert_redirected_to settings_hosting_path
      get settings_hosting_path
      assert_select "select[name='setting[session_inactivity_timeout_minutes]'] option[selected][value='15']"
      assert_select "select[name='setting[session_absolute_timeout_minutes]'] option[selected][value='1440']"
    end

    assert_equal 15, Setting.session_inactivity_timeout_minutes
    assert_equal 1440, Setting.session_absolute_timeout_minutes
  end

  test "invalid values do not partially update either setting" do
    Setting.session_inactivity_timeout_minutes = 30
    Setting.session_absolute_timeout_minutes = 480
    with_self_hosting do
      sign_in users(:sure_support_staff)
      patch settings_session_timeouts_path, params: { setting: {
        session_inactivity_timeout_minutes: "15",
        session_absolute_timeout_minutes: "1.5"
      } }
    end

    assert_redirected_to settings_hosting_path
    assert_equal 30, Setting.session_inactivity_timeout_minutes
    assert_equal 480, Setting.session_absolute_timeout_minutes
    assert_equal I18n.t("settings.hostings.session_security.invalid"), flash[:alert]
  end

  test "ordinary admins cannot update timeout settings" do
    with_self_hosting do
      sign_in users(:family_admin)
      patch settings_session_timeouts_path, params: { setting: {
        session_inactivity_timeout_minutes: "15",
        session_absolute_timeout_minutes: ""
      } }
    end

    assert_redirected_to settings_hosting_path
    assert_nil Setting.session_inactivity_timeout_minutes
  end

  test "blank or missing custom durations cannot disable either timeout" do
    Setting.session_inactivity_timeout_minutes = 30
    Setting.session_absolute_timeout_minutes = 480

    with_self_hosting do
      sign_in users(:sure_support_staff)
      %w[inactivity absolute].each do |timeout|
        [ nil, "", " " ].each do |duration|
          settings = {
            session_inactivity_timeout_minutes: "15",
            session_absolute_timeout_minutes: "60"
          }.stringify_keys
          settings["session_#{timeout}_timeout_minutes"] = "custom"
          settings["session_#{timeout}_custom_minutes"] = duration unless duration.nil?

          patch settings_session_timeouts_path, params: { setting: settings }

          assert_redirected_to settings_hosting_path
          assert_equal I18n.t("settings.hostings.session_security.invalid"), flash[:alert]
          assert_equal 30, Setting.session_inactivity_timeout_minutes
          assert_equal 480, Setting.session_absolute_timeout_minutes
        end
      end
    end
  end

  test "custom durations and explicit Never selections are accepted" do
    Setting.session_inactivity_timeout_minutes = 30
    Setting.session_absolute_timeout_minutes = 480
    with_self_hosting do
      sign_in users(:sure_support_staff)
      patch settings_session_timeouts_path, params: { setting: {
        session_inactivity_timeout_minutes: "custom",
        session_inactivity_custom_minutes: "1",
        session_absolute_timeout_minutes: ""
      } }
    end

    assert_redirected_to settings_hosting_path
    assert_equal I18n.t("settings.hostings.session_security.saved"), flash[:notice]
    assert_equal 1, Setting.session_inactivity_timeout_minutes
    assert_nil Setting.session_absolute_timeout_minutes
  end

  test "an impersonating super admin cannot change the policy" do
    with_self_hosting do
      sign_in users(:sure_support_staff)
      post join_impersonation_sessions_path,
           params: { impersonation_session_id: impersonation_sessions(:in_progress).id }
      patch settings_session_timeouts_path, params: { setting: {
        session_inactivity_timeout_minutes: "15",
        session_absolute_timeout_minutes: ""
      } }
    end

    assert_redirected_to settings_hosting_path
    assert_nil Setting.session_inactivity_timeout_minutes
  end

  test "settings page shows session security only to super admins" do
    with_self_hosting do
      sign_in users(:sure_support_staff)
      get settings_hosting_path
      assert_response :success
      assert_select "h2", text: "Session Security"
      assert_select "select[name='setting[session_inactivity_timeout_minutes]'] option", text: "Never"
      assert_select "select[name='setting[session_absolute_timeout_minutes]'] option", text: "Never"
    end
  end

  test "settings page preserves custom durations and localized preset labels" do
    Setting.session_inactivity_timeout_minutes = 7
    Setting.session_absolute_timeout_minutes = SessionTimeoutPolicy::MAX_TIMEOUT_MINUTES

    with_self_hosting do
      sign_in users(:sure_support_staff)
      get settings_hosting_path

      assert_response :success
      %w[inactivity absolute].each do |timeout|
        assert_select "select[name='setting[session_#{timeout}_timeout_minutes]'] option[selected][value='custom']"
        assert_select "input[name='setting[session_#{timeout}_custom_minutes]'][required]:not([disabled])"
      end
      assert_select "input[name='setting[session_inactivity_custom_minutes]'][value='7']"
      assert_select "input[name='setting[session_absolute_custom_minutes]'][value='525600']"
      assert_select "option[value='5']", text: I18n.t("settings.hostings.session_security.minutes", count: 5)
      assert_select "option[value='60']", text: I18n.t("settings.hostings.session_security.hours", count: 1)
      assert_select "option[value='10080']", text: I18n.t("settings.hostings.session_security.days", count: 7)
    end
  end
end

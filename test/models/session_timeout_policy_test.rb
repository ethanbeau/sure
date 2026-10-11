require "test_helper"

class SessionTimeoutPolicyTest < ActiveSupport::TestCase
  setup do
    Setting.session_inactivity_timeout_minutes = nil
    Setting.session_absolute_timeout_minutes = nil
    @user = users(:family_admin)
    @session = @user.sessions.create!
    @created_at = @session.created_at
    @activity_at = @session.last_activity_at
  end

  test "timeout settings default to unlimited" do
    assert_nil SessionTimeoutPolicy.new.inactivity_timeout
    assert_nil SessionTimeoutPolicy.new.absolute_timeout
    refute SessionTimeoutPolicy.new(@session).expired?
  end

  test "inactivity and absolute limits are independent and expire at the boundary" do
    Setting.session_inactivity_timeout_minutes = 15
    Setting.session_absolute_timeout_minutes = nil
    refute SessionTimeoutPolicy.new(@session, now: @activity_at + 14.minutes).expired?
    assert SessionTimeoutPolicy.new(@session, now: @activity_at + 15.minutes).expired?

    Setting.session_inactivity_timeout_minutes = nil
    Setting.session_absolute_timeout_minutes = 60
    refute SessionTimeoutPolicy.new(@session, now: @created_at + 59.minutes).expired?
    assert SessionTimeoutPolicy.new(@session, now: @created_at + 60.minutes).expired?
  end

  test "activity extends only inactivity and preference writes do not count as activity" do
    Setting.session_inactivity_timeout_minutes = 15
    Setting.session_absolute_timeout_minutes = 60
    now = @activity_at + 14.minutes
    authenticated = Session.authenticate_cookie(@session.id, activity: true, now: now)
    assert_equal now, authenticated.last_activity_at
    assert_equal @created_at, authenticated.created_at
    authenticated.set_preferred_tab("accounts_sidebar_tab", "asset")
    assert_equal now, authenticated.reload.last_activity_at

    assert SessionTimeoutPolicy.new(authenticated, now: @created_at + 60.minutes).expired?
  end

  test "expired session is destroyed and cannot be revived by disabling the timeout" do
    Setting.session_absolute_timeout_minutes = 10
    expired_at = @created_at + 10.minutes
    assert_nil Session.authenticate_cookie(@session.id, now: expired_at)
    assert_not Session.exists?(@session.id)

    Setting.session_absolute_timeout_minutes = nil
    assert_nil Session.authenticate_cookie(@session.id, now: expired_at)
  end

  test "invalid timeout values are rejected, including fractions and values above one year" do
    [ "", " ", 0, -1, 1.5, "1.5", "-1", "0", SessionTimeoutPolicy::MAX_TIMEOUT_MINUTES + 1 ].each do |value|
      assert_raises(ArgumentError) { SessionTimeoutPolicy.new(inactivity_minutes: value) }
    end
    assert_nil SessionTimeoutPolicy.new(inactivity_minutes: nil).inactivity_timeout
  end

  test "whole minute durations accept both supported boundaries" do
    assert_equal 1, SessionTimeoutPolicy.new(inactivity_minutes: "1").inactivity_minutes
    assert_equal SessionTimeoutPolicy::MAX_TIMEOUT_MINUTES,
      SessionTimeoutPolicy.new(absolute_minutes: SessionTimeoutPolicy::MAX_TIMEOUT_MINUTES.to_s).absolute_minutes
  end
end

class Settings::SessionTimeoutsController < ApplicationController
  layout "settings"
  guard_feature unless: -> { self_hosted? }
  before_action :ensure_real_super_admin

  def update
    submitted = params.require(:setting).permit(:session_inactivity_timeout_minutes, :session_absolute_timeout_minutes,
                                                :session_inactivity_custom_minutes, :session_absolute_custom_minutes)
    raise ArgumentError unless submitted.key?(:session_inactivity_timeout_minutes) && submitted.key?(:session_absolute_timeout_minutes)
    parsed = %w[inactivity absolute].index_with do |timeout|
      selection = submitted.fetch("session_#{timeout}_timeout_minutes")
      next nil if selection == ""

      raw = selection == "custom" ? submitted["session_#{timeout}_custom_minutes"] : selection
      SessionTimeoutPolicy.parse_minutes(raw.to_s.strip)
    end

    Setting.transaction do
      Setting.session_inactivity_timeout_minutes = parsed.fetch("inactivity")
      Setting.session_absolute_timeout_minutes = parsed.fetch("absolute")
    end
    redirect_to settings_hosting_path, notice: t("settings.hostings.session_security.saved")
  rescue ArgumentError, ActionController::ParameterMissing
    redirect_to settings_hosting_path, alert: t("settings.hostings.session_security.invalid")
  end

  private

    def ensure_real_super_admin
      real_user = Current.session&.user
      allowed = real_user&.super_admin? && Current.user == real_user && Current.session.active_impersonator_session.nil?
      redirect_to settings_hosting_path, alert: t("settings.hostings.update.not_authorized") unless allowed
    end
end

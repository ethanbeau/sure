class Settings::PreferencesController < ApplicationController
  layout "settings"

  def show
    @user = Current.user
    @family_members = Current.family.users.where.not(id: @user.id).where(active: true)
    @budget_shares = @user.budget_shares_given.index_by(&:viewer_id)
  end

  # Writes per-user boolean preferences stored in the JSONB `users.preferences`
  # column. Mirrors Settings::AppearancesController#update so the toggle card on
  # the Preferences page can submit directly without going through the broader
  # UsersController#update flow (which expects a full user form payload).
  def update
    @user = Current.user
    user_params = params.permit(user: [ :preview_features_enabled, :hide_page_in_background ]).fetch(:user, {})

    @user.transaction do
      @user.lock!
      updated_prefs = (@user.preferences || {}).deep_dup
      user_params.each do |key, value|
        updated_prefs[key] = ActiveModel::Type::Boolean.new.cast(value)
      end
      @user.update!(preferences: updated_prefs)
    end
    redirect_to settings_preferences_path
  end
end

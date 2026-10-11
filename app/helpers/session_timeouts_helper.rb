module SessionTimeoutsHelper
  SESSION_TIMEOUT_PRESETS = {
    inactivity: [ 5, 15, 30, 60, 240, 480, 1440 ].freeze,
    absolute: [ 60, 480, 720, 1440, 10080, 43200 ].freeze
  }.freeze

  def session_timeout_fields
    SESSION_TIMEOUT_PRESETS.map do |name, presets|
      key = "session_#{name}_timeout_minutes"
      current = Setting.public_send(key)
      selection = if current.nil?
        ""
      elsif presets.include?(current)
        current.to_s
      else
        "custom"
      end

      choices = [ [ t("settings.hostings.session_security.never"), "" ] ]
      choices.concat(presets.map { |minutes| [ session_timeout_duration_label(minutes), minutes ] })
      choices << [ t("settings.hostings.session_security.custom"), "custom" ]

      { name: name, key: key, current: current, selection: selection, options: options_for_select(choices, selection) }
    end
  end

  private

    def session_timeout_duration_label(minutes)
      unit, count = if minutes < 60
        [ "minutes", minutes ]
      elsif minutes < 10080
        [ "hours", minutes / 60 ]
      else
        [ "days", minutes / 1440 ]
      end
      t("settings.hostings.session_security.#{unit}", count: count)
    end
end

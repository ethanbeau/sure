# Current instance-wide policy for interactive, cookie-backed browser sessions.
class SessionTimeoutPolicy
  MAX_TIMEOUT_MINUTES = Session::MAX_TIMEOUT_MINUTES

  def initialize(session = nil, now: Time.current, inactivity_minutes: Setting.session_inactivity_timeout_minutes,
                 absolute_minutes: Setting.session_absolute_timeout_minutes)
    @session = session
    @now = now
    @inactivity_minutes = self.class.parse_minutes(inactivity_minutes)
    @absolute_minutes = self.class.parse_minutes(absolute_minutes)
  end

  attr_reader :inactivity_minutes, :absolute_minutes

  def self.activity_request?(request)
    return true if request.headers["X-User-Activity"] == "true"
    return false if request.xhr? || request.headers["Turbo-Frame"].present?
    return false unless request.format.html?
    return true if request.post? || request.patch? || request.put? || request.delete?

    request.get? && %w[navigate document].any? do |value|
      request.headers["Sec-Fetch-Mode"] == value || request.headers["Sec-Fetch-Dest"] == value
    end
  end

  def inactivity_timeout
    inactivity_minutes&.minutes
  end

  def absolute_timeout
    absolute_minutes&.minutes
  end

  def inactivity_deadline
    return unless @session && inactivity_timeout

    (@session.last_activity_at || @session.created_at) + inactivity_timeout
  end

  def absolute_deadline
    return unless @session && absolute_timeout

    @session.created_at + absolute_timeout
  end

  def client_deadlines
    {
      server_now: @now.iso8601(3),
      inactivity_deadline: inactivity_deadline&.iso8601(3),
      absolute_deadline: absolute_deadline&.iso8601(3)
    }
  end

  def expired?
    return false unless @session

    (absolute_deadline && @now >= absolute_deadline) ||
      (inactivity_deadline && @now >= inactivity_deadline)
  end

  def self.parse_minutes(value)
    return nil if value.nil?

    raw = value.to_s
    unless raw.match?(/\A[1-9]\d*\z/) && raw.to_i <= MAX_TIMEOUT_MINUTES
      raise ArgumentError, "Timeout must be a positive whole number of minutes up to #{MAX_TIMEOUT_MINUTES}."
    end
    raw.to_i
  end
end

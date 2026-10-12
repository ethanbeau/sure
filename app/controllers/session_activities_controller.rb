class SessionActivitiesController < ApplicationController
  def create
    response.headers["Cache-Control"] = "private, no-store"
    render json: SessionTimeoutPolicy.new(Current.session).client_deadlines
  end

  private
    def request_authentication
      head :unauthorized
    end
end

class SessionActivitiesController < ApplicationController
  def create
    render json: SessionTimeoutPolicy.new(Current.session).client_deadlines
  end

  private
    def request_authentication
      head :unauthorized
    end
end

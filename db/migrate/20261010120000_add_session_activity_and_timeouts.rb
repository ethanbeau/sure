class AddSessionActivityAndTimeouts < ActiveRecord::Migration[8.1]
  def up
    add_column :sessions, :last_activity_at, :datetime
    execute "UPDATE sessions SET last_activity_at = created_at WHERE last_activity_at IS NULL"
    change_column_default :sessions, :last_activity_at, from: nil, to: -> { "CURRENT_TIMESTAMP" }
    change_column_null :sessions, :last_activity_at, false
  end

  def down
    remove_column :sessions, :last_activity_at
  end
end

#!/usr/bin/env expect
# Deploy all cloud functions non-interactively
set timeout 180
spawn cloudbase fn deploy -e cloud1-d8g3devjh29426fcc
cd /Users/xiaomada/OpenClaw/workspace/location-share

# Select all functions
expect "请选择要部署的云函数"
send " "
expect "全部函数"
send "\r"

# Handle overwrite prompt for existing functions
expect {
  "请选择要覆盖更新" {
    send "a"
    sleep 0.5
    send "\r"
  }
  timeout { }
}

expect eof

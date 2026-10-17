--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Greeting = require(ReplicatedStorage.Shared.Greeting)

print("[Client] " .. Greeting.hello("client"))

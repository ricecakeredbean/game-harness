--!strict
local Greeting = {}

function Greeting.hello(name: string): string
	return "Hello, " .. name
end

return Greeting

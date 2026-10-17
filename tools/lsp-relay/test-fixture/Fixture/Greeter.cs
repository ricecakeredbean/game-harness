namespace Fixture
{
    public class Greeter
    {
        public string Name { get; set; } = "world";

        public string Greet(string who)
        {
            return "Hello " + who;
        }

        public void Reset() { Name = "world"; }
    }

    public enum Mood { Happy, Sad }
}

namespace Fixture
{
    public static class Program
    {
        public static void Main()
        {
            var g = new Greeter();
            System.Console.WriteLine(g.Greet(g.Name));
        }
    }
}

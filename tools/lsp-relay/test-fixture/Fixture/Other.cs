namespace Fixture
{
    // 참조 추가 테스트용 파일
    public class Other
    {
        public void Run() { }
    }
}

namespace Fixture.Sub
{
    // 동명 후보 테스트용
    public class Greeter { public void Greet() { } }
}

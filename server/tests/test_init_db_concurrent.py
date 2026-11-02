"""서버와 MQTT 워커가 동시에 시작해도 스키마 생성이 실패하지 않는다. 임시 DB만 사용, 네트워크 없음."""
import multiprocessing as mp
import os, sys, tempfile, pathlib

SERVER = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))
os.chdir(SERVER)


def start(path, barrier, results):
    from app.utils.database import database as db

    p = pathlib.Path(path)
    db._DATA_DIR, db._DB_PATH = p.parent, p
    barrier.wait()
    try:
        db.init_db()
        results.put("ok")
    except Exception as e:
        results.put(repr(e)[:200])


if __name__ == "__main__":
    mp.set_start_method("spawn")
    for _ in range(5):
        path = os.path.join(tempfile.mkdtemp(), "app.db")
        barrier, results = mp.Barrier(2), mp.Queue()
        procs = [mp.Process(target=start, args=(path, barrier, results)) for _ in range(2)]
        for p in procs:
            p.start()
        outcome = [results.get(timeout=60) for _ in procs]
        for p in procs:
            p.join()
        assert outcome == ["ok", "ok"], outcome
    print("[ok] 두 프로세스가 같은 새 DB에 동시에 init_db를 돌려도 둘 다 성공한다")

    print("\n전체 통과")

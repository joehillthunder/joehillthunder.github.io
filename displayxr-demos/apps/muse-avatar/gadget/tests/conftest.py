import asyncio

import pytest


@pytest.fixture(autouse=True)
def event_loop_for_fixtures():
    """Python 3.9 binds asyncio queues and events to a loop when they are made.

    Tests build fakes before asyncio.run() starts its own loop, so give each test a
    current loop to bind to (3.10 and later no longer need it).
    """
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    yield
    asyncio.set_event_loop(None)
    loop.close()

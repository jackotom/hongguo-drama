"""Independent wire data for an explicit danmaku reaction; no I/O or signing.

The host must resolve video_id from the selected series/episode. A browser-
provided media URL, episode number, or series ID is not that identity.
"""
import re

PATH = '/novel/commentapi/comment/do_action/v1/'


def make_body(comment_id, video_id, liked, *, from_overlay=False):
    """Keep the target danmaku and its actual video identity separate."""
    for value, minimum, maximum in ((comment_id, 5, 30), (video_id, 8, 24)):
        if (not isinstance(value, str) or not minimum <= len(value) <= maximum
                or not re.fullmatch(r'[1-9][0-9]*', value)):
            raise ValueError('弹幕或本集标识无效，未准备点赞操作')
    if type(liked) is not bool or type(from_overlay) is not bool:
        raise ValueError('弹幕点赞操作无效')
    origin = 'outer_show_digg_source' if liked and from_overlay else 'default_digg_source'
    return {
        'object_id': comment_id,
        'object_type': 2,
        'action_type': 8 if liked else 9,
        'comment_type': 20,
        'aid': 8662,
        'business_param': {'shark_param': {
            'enter_from': 'MainFragmentActivity',
            'previous_page': '',
            'page_list': 'MainFragmentActivity',
            'target': comment_id,
            'section_id': video_id,
            'action_source': origin,
        }},
    }

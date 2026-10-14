# language: en
@rooms-agents
Feature: Cowork rooms and Fleet agents across real daemons

  @cowork-room
  Scenario Outline: A remote client joins a Cowork room and exchanges messages
    Given Cowork is connected to server <host>
    When the operator creates Cowork room "<room>" for goal "Review the release"
    And identity "<guest>" on server <remote> joins the room as "Reviewer"
    Then the room has an active "Reviewer" seat for "<guest>"
    When "<guest>" sends "Review started" to the room
    Then the Cowork archive contains "Review started"
    When the operator posts "Please report findings" to the room
    Then "<guest>" receives "Please report findings" from the room

    @host-a
    Examples: Cowork hosted on A
      | host | remote | room                  | guest           |
      | A    | B      | Cross-server review A | RemoteReviewerB |

    @host-b
    Examples: Cowork hosted on B
      | host | remote | room                  | guest           |
      | B    | A      | Cross-server review B | RemoteReviewerA |

  @fleet-single
  Scenario Outline: Fleet launches a task agent into a Cowork room
    Given Fleet uses a deterministic ACP agent and Cowork on server <host> with room template "solo":
      | slot      | role      |
      | developer | Developer |
    When Fleet starts a task using the "solo" room template
    Then every configured Fleet member has an active Cowork room seat
    And each room seat belongs to a live Fleet agent

    @host-a
    Examples: Fleet hosted on A
      | host |
      | A    |

    @host-b
    Examples: Fleet hosted on B
      | host |
      | B    |

  @fleet-completion
  Scenario: Completing a Fleet task deletes its room and retires its members
    Given Fleet uses a deterministic ACP agent and Cowork on server A with room template "single":
      | slot      | role      |
      | developer | Developer |
    When Fleet starts a task using the "single" room template
    Then every configured Fleet member has an active Cowork room seat
    And each room seat belongs to a live Fleet agent
    When the operator reviews and finishes the Fleet task
    Then the task is done its room is deleted and members are retired

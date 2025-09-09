import { Body, ConflictException, Controller, Get, Post } from '@nestjs/common';
import { Company } from '../../db/models/Company';
import {
  Ticket,
  TicketCategory,
  TicketStatus,
  TicketType,
} from '../../db/models/Ticket';
import { User, UserRole } from '../../db/models/User';

interface newTicketDto {
  type: TicketType;
  companyId: number;
}

interface TicketDto {
  id: number;
  type: TicketType;
  companyId: number;
  assigneeId: number;
  status: TicketStatus;
  category: TicketCategory;
}

@Controller('api/v1/tickets')
export class TicketsController {
  @Get()
  async findAll() {
    return await Ticket.findAll({ include: [Company, User] });
  }

  @Post()
  async create(@Body() newTicketDto: newTicketDto) {
    const { type, companyId } = newTicketDto;
    const category = this.getTicketCategory(type);
    const userRole = this.getUserRole(type);

    const registrationAddressChangeTickets = await Ticket.findAll({
      where: {
        companyId,
        category: TicketCategory.corporate,
        type: TicketType.registrationAddressChange,
        status: TicketStatus.open,
      },
    });

    if (
      type === TicketType.registrationAddressChange &&
      registrationAddressChangeTickets.length > 1
    ) {
      throw new ConflictException(
        `duplicate error crating ticket ${category} already exist for company ${companyId}`,
      );
    }

    let assignees = await User.findAll({
      where: { companyId, role: userRole },
      order: [['createdAt', 'DESC']],
    });

    if (!assignees.length && type === TicketType.registrationAddressChange) {
      const directors = await User.findAll({
        where: { companyId, role: UserRole.director },
        order: [['createdAt', 'DESC']],
      });

      if (assignees.length > 1) {
        throw new ConflictException(
          `Multiple users with role ${UserRole.director}. Cannot create a ticket`,
        );
      }
      assignees = directors;
    }

    if (!assignees.length)
      throw new ConflictException(
        `Cannot find user with role ${userRole} to create a ticket`,
      );

    if (userRole === UserRole.corporateSecretary && assignees.length > 1)
      throw new ConflictException(
        `Multiple users with role ${userRole}. Cannot create a ticket`,
      );

    const assignee = assignees[0];

    if (type === TicketType.strikeOff) {
      this.resolveOtherTickets(companyId);
    }

    const ticket = await Ticket.create({
      companyId,
      assigneeId: assignee.id,
      category,
      type,
      status: TicketStatus.open,
    });

    const ticketDto: TicketDto = {
      id: ticket.id,
      type: ticket.type,
      assigneeId: ticket.assigneeId,
      status: ticket.status,
      category: ticket.category,
      companyId: ticket.companyId,
    };

    return ticketDto;
  }

  private getTicketCategory(type: TicketType): TicketCategory {
    switch (type) {
      case TicketType.managementReport:
        return TicketCategory.accounting;
      case TicketType.registrationAddressChange:
        return TicketCategory.corporate;
      case TicketType.strikeOff:
        return TicketCategory.management;
      default:
        return TicketCategory.accounting;
    }
  }

  private getUserRole(type: TicketType): UserRole {
    switch (type) {
      case TicketType.managementReport:
        return UserRole.accountant;
      case TicketType.registrationAddressChange:
        return UserRole.corporateSecretary;
      case TicketType.strikeOff:
        return UserRole.director;
      default:
        return UserRole.accountant;
    }
  }

  private resolveOtherTickets(companyId: number) {
    void Ticket.update(
      { status: TicketStatus.resolved },
      { where: { companyId, status: TicketStatus.open } },
    );
  }
}
